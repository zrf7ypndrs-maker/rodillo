// Daily coach brief:  node tools/daily.mjs <path-to-rodillo-data> [YYYY-MM-DD]
// Validate after edits: node tools/daily.mjs <path-to-rodillo-data> --check
//
// Prints everything the morning coach run needs to decide whether to keep, scale or
// swap today's session: WHOOP today vs personal baselines, ride load,
// and the plan for the next 7 days with each workout's duration, TSS and intensity.
import fs from 'node:fs';
import path from 'node:path';
import { loadSeries, formLabel } from '../js/stats.js';
import { flatten, totalDuration, estimateTSS } from '../js/engine/workout.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = path.resolve(process.argv[2] || '../rodillo-data');
const check = process.argv.includes('--check');
const argDate = process.argv.slice(3).find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const austinToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const today = argDate || austinToday();

const readJson = (p, fallback = null) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback);
const addDays = (key, n) => { const d = new Date(key + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dow = (key) => new Date(key + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r1 = (x) => (x == null ? '-' : Math.round(x * 10) / 10);

// ---- library: public workouts, overridden/extended by coach/workouts.json
const idx = readJson(path.join(root, 'workouts', 'index.json'));
const library = new Map(idx.workouts.map((f) => { const w = readJson(path.join(root, 'workouts', f)); return [w.id, w]; }));
const coachW = readJson(path.join(dir, 'coach', 'workouts.json'), { version: 1, workouts: [] });
for (const w of coachW.workouts || []) library.set(w.id, { ...w, _coach: true });
// Agustín's own workouts from the in-app builder (rodillo-data workouts/mine.json); the plan may use their ids
const mineW = readJson(path.join(dir, 'workouts', 'mine.json'), { workouts: [] });
for (const w of mineW.workouts || []) if (!library.has(w.id)) library.set(w.id, { ...w, _mine: true });
const plan = readJson(path.join(dir, 'coach', 'plan.json')) || readJson(path.join(root, 'plans', 'current.json'));

function describe(w) {
  const segs = flatten(w, plan.ftp || 200);
  const ergWork = segs.filter((s) => s.kind === 'erg' && s.dur >= 30).map((s) => (s.from + s.to) / 2);
  const peak = ergWork.length ? Math.max(...ergWork) : null;
  const hard = (w.tags || []).some((t) => ['vo2', 'threshold', 'test', 'max'].includes(t)) || segs.some((s) => s.kind === 'erg' && s.dur >= 120 && (s.from + s.to) / 2 >= 0.88);
  const sim = segs.every((s) => s.kind === 'sim');
  return `${w.name} [${w.id}${w._coach ? ', coach' : ''}] ${Math.round(totalDuration(w) / 60)} min, ~${estimateTSS(w) ?? '?'} TSS, ${sim ? 'slope mode' : `peak ${Math.round(peak * 100)}% FTP`}${hard ? ', HARD' : ''}`;
}

// ---- --check: every plan entry must resolve; every coach workout must flatten
if (check) {
  const errs = [];
  for (const [k, v] of Object.entries(plan.days || {})) {
    if (['rest', 'strength'].includes(v)) continue;
    if (!library.has(v)) errs.push(`plan ${k}: unknown workout "${v}"`);
  }
  for (const w of coachW.workouts || []) {
    try { if (!flatten(w).length) errs.push(`workout ${w.id}: no steps`); } catch (e) { errs.push(`workout ${w.id}: ${e.message}`); }
    if (!w.id || !w.name) errs.push('a coach workout is missing id or name');
  }
  if (plan.maxMinutes) {
    for (const [k, v] of Object.entries(plan.days || {})) {
      const w = library.get(v);
      if (w && totalDuration(w) > plan.maxMinutes * 60 + 30) errs.push(`plan ${k}: ${v} is ${Math.round(totalDuration(w) / 60)} min, over the ${plan.maxMinutes}-min cap`);
    }
  }
  for (const [k, v] of Object.entries(plan.daily || {})) {
    if (!['kept', 'scaled', 'swapped', 'moved', 'rest'].includes(v.action)) errs.push(`daily ${k}: bad action "${v.action}"`);
    if (!v.reason) errs.push(`daily ${k}: missing reason`);
  }
  if (errs.length) { console.error('PLAN CHECK FAILED\n' + errs.join('\n')); process.exit(1); }
  console.log(`Plan OK: ${Object.keys(plan.days).length} days, ${(coachW.workouts || []).length} coach workouts, ${Object.keys(plan.daily || {}).length} daily decisions.`);
  process.exit(0);
}

console.log(`# Coach brief for ${dow(today)} ${today} (Austin)\n`);

// ---- WHOOP
const whoop = readJson(path.join(dir, 'whoop', 'daily.json'), { days: {} }).days;
const t = whoop[today];
const prev = (n, field) => { const out = []; for (let i = 1; i <= n; i++) { const v = whoop[addDays(today, -i)]?.[field]; if (v != null) out.push(v); } return out; };
if (!t || t.recovery == null) {
  console.log(`WHOOP: today NOT SCORED yet (latest day on file: ${Object.keys(whoop).sort().at(-1) || 'none'}).`);
} else {
  const hrv7 = avg(prev(7, 'hrv')), hrv60 = avg(prev(60, 'hrv')), rhr60 = avg(prev(60, 'rhr')), sleep7 = avg(prev(7, 'sleepHours'));
  const zone = t.recovery >= 67 ? 'GREEN' : t.recovery >= 34 ? 'YELLOW' : 'RED';
  console.log(`WHOOP today: recovery ${t.recovery}% (${zone})${t.calibrating ? ' [calibrating]' : ''}`);
  console.log(`  HRV ${r1(t.hrv)} ms  (7d avg ${r1(hrv7)}, 60d avg ${r1(hrv60)}, today vs 60d ${hrv60 ? Math.round((t.hrv / hrv60 - 1) * 100) : '-'}%)`);
  console.log(`  RHR ${t.rhr ?? '-'}  (60d avg ${r1(rhr60)}, ${rhr60 && t.rhr ? (t.rhr - rhr60 >= 0 ? '+' : '') + r1(t.rhr - rhr60) : '-'} bpm)`);
  console.log(`  Sleep ${t.sleepHours ?? '-'} h, performance ${t.sleepPerf ?? '-'}%  (7d avg ${r1(sleep7)} h)  resp ${t.respRate ?? '-'}  skin temp ${t.skinTemp ?? '-'}`);
}
const recRun = []; for (let i = 1; i <= 3; i++) { const v = whoop[addDays(today, -i)]?.recovery; recRun.push(v ?? '-'); }
console.log(`  Recovery previous 3 days (newest first): ${recRun.join(', ')}`);

// ---- Ride load
const rides = (readJson(path.join(dir, 'index.json'), { rides: [] }).rides || []).filter((r) => r.source !== 'demo');
if (rides.length) {
  const s = loadSeries(rides, new Date(today + 'T12:00:00')).at(-1);
  console.log(`\nRide load (${rides.length} rides on file, ${rides.filter((r) => r.tags?.includes("imported")).length} imported from Strava/Garmin): CTL ${s.ctl}  ATL ${s.atl}  TSB ${s.tsb} (${formLabel(s.tsb)})`);
} else console.log('\nRide load: no rides on file yet.');
console.log('Rides last 10 days:');
const since = addDays(today, -10);
const recent = rides.filter((r) => r.id.slice(0, 10) >= since && r.id.slice(0, 10) <= today);
if (!recent.length) console.log('  none');
for (const r of recent) {
  const c = r.compliance ? ` intervals ${r.compliance.avg}% (min ${r.compliance.min}%, ${r.compliance.reps} reps)` : '';
  console.log(`  ${r.id.slice(0, 10)} ${dow(r.id.slice(0, 10))}  ${r.name}${r.workoutId ? ` [${r.workoutId}]` : ''}  ${Math.round(r.durSec / 60)} min  TSS ${r.tss}${r.tssFrom === "hr" ? " (HR)" : ""}  IF ${r.if ?? "-"}  HR ${r.avgHr ?? '-'}${c}${r.decoupling != null ? ` drift ${r.decoupling}%` : ''}`);
}
const lastRamp = rides.filter((r) => r.workoutId === 'ramp-test' && r.bests?.[60]).at(-1);
if (lastRamp) {
  const newFtp = Math.round(lastRamp.bests[60] * 0.75);
  // the app now asks after the ride: Update writes ftpSetAt, Keep writes ftpDeclinedAt; either one settles it
  const day = lastRamp.id.slice(0, 10);
  const pending = !((plan.ftpSetAt || '') >= day || (plan.ftpDeclinedAt || '') >= day);
  console.log(`  Last ramp test ${lastRamp.id.slice(0, 10)}: best 1-min ${lastRamp.bests[60]} W -> FTP ${newFtp} W${pending ? '  >> NOT YET IN PLAN: set plan.ftp and plan.ftpSetAt (see DAILY.md step 3)' : ''}`);
}
const rodeToday = rides.some((r) => r.id.slice(0, 10) === today && r.durSec >= 600);
if (rodeToday) console.log(`  >> Already rode today: do NOT change today.`);

// ---- Planned vs done, last 7 days
console.log('\nPlan vs done, last 7 days:');
for (let i = -7; i < 0; i++) {
  const k = addDays(today, i), v = plan.days?.[k];
  if (!v || v === 'rest' || v === 'strength') { console.log(`  ${k} ${dow(k)}  ${v || '-'}`); continue; }
  const done = rides.filter((r) => r.id.slice(0, 10) === k && r.durSec >= 600);
  console.log(`  ${k} ${dow(k)}  ${v}  ${done.length ? 'DONE: ' + done.map((r) => `${r.name} TSS ${r.tss}`).join(', ') : 'NOT RIDDEN'}`);
}

// ---- Next 7 days
console.log(`\nPlan "${plan.name}" (FTP ${plan.ftp} W${plan.ftpSetAt ? `, set ${plan.ftpSetAt}${plan.ftpSource ? ` from ${plan.ftpSource}` : ''}` : ', not tested yet'}${plan.maxMinutes ? `, max ${plan.maxMinutes} min per ride` : ''}), today + 6:`);
for (let i = 0; i < 7; i++) {
  const k = addDays(today, i), v = plan.days?.[k];
  const w = v && library.get(v);
  const what = !v ? 'nothing planned' : w ? describe(w) : v;
  const note = plan.notes?.[k] ? `\n      note: ${plan.notes[k]}` : '';
  const d = plan.daily?.[k] ? `\n      already decided: ${plan.daily[k].action}: ${plan.daily[k].reason}` : '';
  console.log(`  ${i === 0 ? '>' : ' '} ${k} ${dow(k)}  ${what}${note}${d}`);
}

console.log('\nDecisions on file (last 5):');
const dec = Object.entries(plan.daily || {}).sort().slice(-5);
if (!dec.length) console.log('  none');
for (const [k, v] of dec) console.log(`  ${k} ${v.action}${v.from ? ` (from ${v.from})` : ''}: ${v.reason}`);
